/** Repository identity from a Git remote URL, and the PR links built from it. */

import { repositoryPath, type RemoteRepo } from "../../runtime/forge-remote";

export {
  forgeRepoOf,
  parseRemote,
  repositoryPath,
  type RemoteRepo,
} from "../../runtime/forge-remote";

function isAzureHost(host: string): boolean {
  return (
    host === "dev.azure.com" || host === "ssh.dev.azure.com" || host.endsWith(".visualstudio.com")
  );
}

/**
 * Organization and project of an Azure DevOps remote: `<org>/<project>/_git` (HTTPS),
 * `v3/<org>/<project>` (SSH, also on `vs-ssh.visualstudio.com`), or `<project>/_git` on
 * `<org>.visualstudio.com`, optionally after `DefaultCollection`. Null otherwise.
 */
function azureProject(repo: RemoteRepo): { organization: string; project: string } | null {
  const segments = repo.owner.split("/").filter((segment) => segment && segment !== "_git");
  const ssh = repo.host === "ssh.dev.azure.com" || repo.host === "vs-ssh.visualstudio.com";
  if (ssh && segments[0] === "v3") segments.shift();
  if (repo.host.endsWith(".visualstudio.com") && !ssh) {
    if (segments[0]?.toLowerCase() === "defaultcollection") segments.shift();
    const organization = repo.host.slice(0, -".visualstudio.com".length);
    return segments.length === 1 && organization ? { organization, project: segments[0]! } : null;
  }
  return segments.length === 2 ? { organization: segments[0]!, project: segments[1]! } : null;
}

/**
 * The web URL of PR `number` on the remote's host, for `github.com`, `gitlab.com` and Azure
 * DevOps only; null for any other host. Built from a checkout's own remote, never a record.
 */
export function pullRequestUrl(repo: RemoteRepo, number: number): string | null {
  if (repo.host === "github.com") {
    return `https://github.com/${repositoryPath(repo)}/pull/${number}`;
  }
  if (repo.host === "gitlab.com") {
    return `https://gitlab.com/${repositoryPath(repo)}/-/merge_requests/${number}`;
  }
  if (isAzureHost(repo.host)) {
    const located = azureProject(repo);
    if (!located) return null;
    const [org, project, name] = [located.organization, located.project, repo.repo].map(
      encodeURIComponent,
    );
    return `https://dev.azure.com/${org}/${project}/_git/${name}/pullrequest/${number}`;
  }
  return null;
}

/** The PR number a recorded PR URL names, with the ref family it lives under on the remote. */
export function pullRequestOf(
  url: string | undefined,
): { number: number; ref: "pull" | "merge-requests" } | null {
  if (!url) return null;
  const merge = /\/merge_requests\/(\d+)(?:[/?#]|$)/.exec(url);
  if (merge) return { number: Number(merge[1]), ref: "merge-requests" };
  const pull = /\/pull(?:request)?\/(\d+)(?:[/?#]|$)/.exec(url);
  return pull ? { number: Number(pull[1]), ref: "pull" } : null;
}

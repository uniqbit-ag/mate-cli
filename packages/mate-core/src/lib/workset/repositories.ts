import fs from "node:fs";

import { workingRepoGit } from "../delivery/branches";
import { parseRemote, repositoryPath } from "../delivery/forge";
import { readCompanionRegistry } from "../orchestrator/repository-link";
import { linkedCheckoutsOf } from "../orchestrator/umbrella-checkouts";

/** Factory mode's configured clone URLs, comma-separated, as the appliance hands them to Studio. */
export const FACTORY_REPOSITORIES_ENV = "MATE_FACTORY_REPOSITORIES";

/** `org/repository` of a remote URL, or null when it is not a forge URL. */
function identityOf(url: string): string | null {
  const parsed = parseRemote(url);
  return parsed ? repositoryPath(parsed) : null;
}

const readOrigin = (checkout: string) => workingRepoGit(checkout).remoteUrl();

/**
 * Where each Working Repository a Workset may name is cloned from, by `org/repository`:
 * the `origin` of each repository linked to the companion whose path exists on this
 * machine, an Umbrella Repository's children included, then the configured factory
 * repositories. A linked origin wins.
 */
export async function repositorySources(
  companionPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, string>> {
  let repos: { path: string }[] = [];
  try {
    repos = (await readCompanionRegistry(companionPath)).repos;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const linked = await Promise.all(
    repos.map(async (repo): Promise<[string, string][]> => {
      if (!fs.existsSync(repo.path)) return [];
      return (await linkedCheckoutsOf(repo, readOrigin)).flatMap(({ origin, remote }) =>
        origin && remote ? [[repositoryPath(remote), origin] as [string, string]] : [],
      );
    }),
  );
  const sources = new Map<string, string>();
  for (const [identity, remote] of linked.flat()) {
    if (!sources.has(identity)) sources.set(identity, remote);
  }
  for (const url of (env[FACTORY_REPOSITORIES_ENV] ?? "").split(",")) {
    const trimmed = url.trim();
    const identity = trimmed ? identityOf(trimmed) : null;
    if (identity && !sources.has(identity)) sources.set(identity, trimmed);
  }
  return sources;
}

/** The `org/repository` names a new Workset may name, sorted. */
export async function linkedRepositoryIdentities(
  companionPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return [...(await repositorySources(companionPath, env)).keys()].toSorted();
}

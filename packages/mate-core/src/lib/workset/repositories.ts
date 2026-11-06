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

interface LinkedRemote {
  /** The registry ID the companion links the checkout under. */
  id: string;
  identity: string;
  remote: string;
  /** The registry entry's own folder, not one of an Umbrella Repository's children. */
  own: boolean;
}

/**
 * Each checkout linked to the companion whose path exists here and has a forge `origin`,
 * an Umbrella Repository's children included.
 */
async function linkedRemotes(companionPath: string): Promise<LinkedRemote[]> {
  let repos: { id: string; path: string }[] = [];
  try {
    repos = (await readCompanionRegistry(companionPath)).repos;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const linked = await Promise.all(
    repos.map(async (repo): Promise<LinkedRemote[]> => {
      if (!fs.existsSync(repo.path)) return [];
      return (await linkedCheckoutsOf(repo, readOrigin)).flatMap(
        ({ path: checkout, origin, remote }) =>
          origin && remote
            ? [
                {
                  id: repo.id,
                  identity: repositoryPath(remote),
                  remote: origin,
                  own: checkout === repo.path,
                },
              ]
            : [],
      );
    }),
  );
  return linked.flat();
}

function sourcesOf(linked: LinkedRemote[], env: NodeJS.ProcessEnv): Map<string, string> {
  const sources = new Map<string, string>();
  for (const { identity, remote } of linked) {
    if (!sources.has(identity)) sources.set(identity, remote);
  }
  for (const url of (env[FACTORY_REPOSITORIES_ENV] ?? "").split(",")) {
    const trimmed = url.trim();
    const identity = trimmed ? identityOf(trimmed) : null;
    if (identity && !sources.has(identity)) sources.set(identity, trimmed);
  }
  return sources;
}

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
  return sourcesOf(await linkedRemotes(companionPath), env);
}

/** The `org/repository` names a new Workset may name, sorted. */
export async function linkedRepositoryIdentities(
  companionPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  return (await linkedRepositoryCatalog(companionPath, env)).identities;
}

export interface LinkedRepositoryCatalog {
  /** The `org/repository` names a new Workset may name, sorted. */
  identities: string[];
  /** `org/repository` of each linked repository by its registry ID. */
  aliases: Map<string, string>;
}

/**
 * {@link linkedRepositoryIdentities} plus the registry IDs, from one remote lookup per
 * checkout. An Umbrella Repository's ID stands for several repositories, so it maps to none.
 */
export async function linkedRepositoryCatalog(
  companionPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LinkedRepositoryCatalog> {
  const linked = await linkedRemotes(companionPath);
  return {
    identities: [...sourcesOf(linked, env).keys()].toSorted(),
    aliases: new Map(linked.filter(({ own }) => own).map(({ id, identity }) => [id, identity])),
  };
}

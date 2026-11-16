import fs from "node:fs";

import { workingRepoGit } from "../delivery/branches";
import { repositoryPath } from "../delivery/forge";
import { readCompanionRegistry } from "../orchestrator/repository-link";
import { linkedCheckoutsOf } from "../orchestrator/umbrella-checkouts";
import { gitTokenKeyOf } from "../factory/git-credential-store";
import { readLocalRepositories, repositoryIdentityOf } from "./factory-local";

/** Factory mode's configured clone URLs, comma-separated, as the appliance hands them to Studio. */
export const FACTORY_REPOSITORIES_ENV = "MATE_FACTORY_REPOSITORIES";

/** Where a repository a Workset may name comes from; a linked origin wins over the list, the list over the environment. */
export type RepositorySourceKind = "linked" | "list" | "environment";

interface Source {
  url: string;
  kind: RepositorySourceKind;
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

function sourcesOf(
  linked: LinkedRemote[],
  listed: string[],
  env: NodeJS.ProcessEnv,
): Map<string, Source> {
  const sources = new Map<string, Source>();
  for (const { identity, remote } of linked) {
    if (!sources.has(identity)) sources.set(identity, { url: remote, kind: "linked" });
  }
  const add = (url: string, kind: RepositorySourceKind) => {
    const trimmed = url.trim();
    const identity = trimmed ? repositoryIdentityOf(trimmed) : null;
    if (identity && !sources.has(identity)) sources.set(identity, { url: trimmed, kind });
  };
  for (const url of listed) add(url, "list");
  for (const url of (env[FACTORY_REPOSITORIES_ENV] ?? "").split(",")) add(url, "environment");
  return sources;
}

/**
 * Where each Working Repository a Workset may name is cloned from, by `org/repository`:
 * the `origin` of each repository linked to the companion whose path exists on this
 * machine, an Umbrella Repository's children included, then the companion's
 * `factory.local.yaml` list, then the configured factory repositories. The first wins.
 */
export async function repositorySources(
  companionPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, string>> {
  const [linked, local] = await Promise.all([
    linkedRemotes(companionPath),
    readLocalRepositories(companionPath),
  ]);
  return new Map(
    [...sourcesOf(linked, local.urls, env)].map(([identity, source]) => [identity, source.url]),
  );
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
  /** Where each of `identities` comes from, so a picker offers removal only for the list's own. */
  kinds: Map<string, RepositorySourceKind>;
  /** `host/org` Git token key of each of `identities`' HTTP(S) clone URL; SSH and organization-less URLs take no token and are left out. */
  keys: Map<string, string>;
  /** Why `factory.local.yaml` is unusable, naming the file and the entry; null when it is fine. */
  problem: string | null;
}

/**
 * {@link linkedRepositoryIdentities} plus the registry IDs, from one remote lookup per
 * checkout. An Umbrella Repository's ID stands for several repositories, so it maps to none.
 */
export async function linkedRepositoryCatalog(
  companionPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LinkedRepositoryCatalog> {
  const [linked, local] = await Promise.all([
    linkedRemotes(companionPath),
    readLocalRepositories(companionPath),
  ]);
  const sources = sourcesOf(linked, local.urls, env);
  return {
    identities: [...sources.keys()].toSorted(),
    aliases: new Map(linked.filter(({ own }) => own).map(({ id, identity }) => [id, identity])),
    kinds: new Map([...sources].map(([identity, source]) => [identity, source.kind])),
    keys: new Map(
      [...sources].flatMap(([identity, source]) => {
        const key = gitTokenKeyOf(source.url);
        return key ? [[identity, key] as const] : [];
      }),
    ),
    problem: local.problem,
  };
}

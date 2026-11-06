import fs from "node:fs";

import { workingRepoGit } from "../delivery/branches";
import { parseRemote } from "../delivery/forge";
import { readCompanionRegistry } from "../orchestrator/repository-link";

/** Factory mode's configured clone URLs, comma-separated, as the appliance hands them to Studio. */
export const FACTORY_REPOSITORIES_ENV = "MATE_FACTORY_REPOSITORIES";

/** `org/repository` of a remote URL, or null when it is not a forge URL. */
export function identityOf(url: string): string | null {
  const parsed = parseRemote(url);
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

interface LinkedRemote {
  /** The registry ID the companion links the repository under. */
  id: string;
  identity: string;
  remote: string;
}

/** Each repository linked to the companion whose path exists here and has a forge `origin`. */
async function linkedRemotes(companionPath: string): Promise<LinkedRemote[]> {
  let repos: { id: string; path: string }[] = [];
  try {
    repos = (await readCompanionRegistry(companionPath)).repos;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const linked = await Promise.all(
    repos.map(async (repo): Promise<LinkedRemote | null> => {
      if (!fs.existsSync(repo.path)) return null;
      const remote = await workingRepoGit(repo.path).remoteUrl();
      const identity = remote ? identityOf(remote) : null;
      return identity && remote ? { id: repo.id, identity, remote } : null;
    }),
  );
  return linked.filter((entry): entry is LinkedRemote => entry !== null);
}

function sourcesOf(linked: LinkedRemote[], env: NodeJS.ProcessEnv): Map<string, string> {
  const sources = new Map<string, string>();
  for (const { identity, remote } of linked)
    if (!sources.has(identity)) sources.set(identity, remote);
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
 * machine, then the configured factory repositories. A linked origin wins.
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

/** {@link linkedRepositoryIdentities} plus the registry IDs, from one remote lookup per repository. */
export async function linkedRepositoryCatalog(
  companionPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LinkedRepositoryCatalog> {
  const linked = await linkedRemotes(companionPath);
  return {
    identities: [...sourcesOf(linked, env).keys()].toSorted(),
    aliases: new Map(linked.map(({ id, identity }) => [id, identity])),
  };
}

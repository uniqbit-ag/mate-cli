import fs from "node:fs";

import { workingRepoGit } from "../delivery/branches";
import { parseRemote } from "../delivery/forge";
import { readCompanionRegistry } from "../orchestrator/repository-link";

/** Factory mode's configured clone URLs, comma-separated, as the appliance hands them to Studio. */
export const FACTORY_REPOSITORIES_ENV = "MATE_FACTORY_REPOSITORIES";

function identityOf(url: string): string | null {
  const parsed = parseRemote(url);
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
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
  let repos: { path: string }[] = [];
  try {
    repos = (await readCompanionRegistry(companionPath)).repos;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const linked = await Promise.all(
    repos.map(async (repo): Promise<[string, string] | null> => {
      if (!fs.existsSync(repo.path)) return null;
      const remote = await workingRepoGit(repo.path).remoteUrl();
      const identity = remote ? identityOf(remote) : null;
      return identity && remote ? [identity, remote] : null;
    }),
  );
  const sources = new Map<string, string>();
  for (const entry of linked) if (entry && !sources.has(entry[0])) sources.set(entry[0], entry[1]);
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

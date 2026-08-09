import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "yaml";

import { FRAMEWORK_NAME } from "../../framework";
import type { LinkedRepository } from "./types";

export function companionRegistryPath(companionPath: string): string {
  return path.join(path.resolve(companionPath), `.${FRAMEWORK_NAME}`, "config", "registry.yaml");
}

export interface CompanionRegistryReadResult {
  repos: LinkedRepository[];
}

/**
 * Parses a companion's `registry.yaml` without the writes {@link
 * WorkingRepoStore.load} performs (legacy-field migration, stale-pointer
 * cleanup). Callers that must not mutate registry state on a read (e.g.
 * inventory, materialization) use this instead. Throws ENOENT when the file
 * doesn't exist; throws on unparsable YAML.
 */
export async function readCompanionRegistry(
  companionPath: string,
): Promise<CompanionRegistryReadResult> {
  const raw = await fs.readFile(companionRegistryPath(companionPath), "utf8");
  const parsed = parse(raw) as { repos?: unknown } | null;
  const rawRepos = Array.isArray(parsed?.repos) ? parsed.repos : [];
  const repos = rawRepos
    .filter(
      (entry): entry is LinkedRepository =>
        Boolean(entry) && typeof entry.id === "string" && typeof entry.path === "string",
    )
    .map(({ id, path: repoPath }) => ({ id, path: repoPath }));
  return { repos };
}

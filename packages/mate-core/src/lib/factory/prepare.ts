import { readWorksets, type WorksetRecord } from "../workset/record";
import { repositorySources } from "../workset/repositories";
import type { FactoryClient } from "./client";
import { FactoryError } from "./ids";

/**
 * Makes a Workset's container ready for work: cloned or fetched, its worktree on the
 * delivery branch, the container created or started, and the worktree linked to the
 * companion. Idempotent, so a session and every AFK turn may call it; a Workset that
 * reached Ready without a session gets its container here.
 */
export async function prepareWorkset(
  client: FactoryClient,
  companionPath: string,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorksetRecord> {
  const record = (await readWorksets(companionPath)).worksets.find((entry) => entry.id === id);
  if (!record) throw new FactoryError(`this companion has no valid Workset ${id}`);
  if (record.repositories.length !== 1) {
    throw new FactoryError(
      `Workset ${id} names ${record.repositories.length} repositories; sessions need exactly one`,
    );
  }
  const repository = record.repositories[0]!;
  const remoteUrl = (await repositorySources(companionPath, env)).get(repository);
  if (!remoteUrl) {
    throw new FactoryError(
      `${repository} is neither linked here nor a configured factory repository`,
    );
  }
  await client.spawn({ id, repository, remoteUrl, companion: companionPath });
  const link = await client.exec({
    id,
    command: ["mate", "working", "link", "--companion", companionPath, "--yes"],
  });
  if (link.status !== 0) {
    throw new FactoryError(`linking the worktree failed: ${(link.stderr || link.stdout).trim()}`);
  }
  return record;
}

import { isRepositoryIdentity, isWorksetId } from "../workset/record";
import { defaultDeliveryBranch } from "../delivery/record";

/** Workset identifiers and the names derived from them. */

export class FactoryError extends Error {
  /** `busy`: every running Workset container is in use; retry once one frees. */
  constructor(
    message: string,
    readonly code?: "busy",
  ) {
    super(message);
    this.name = "FactoryError";
  }
}

export function assertWorksetId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !isWorksetId(id)) {
    throw new FactoryError(
      `Workset identifier ${JSON.stringify(id)} is not a kebab-case name (lowercase letters, digits and single hyphens)`,
    );
  }
}

export function assertRepository(repository: unknown): asserts repository is string {
  if (
    typeof repository !== "string" ||
    !isRepositoryIdentity(repository) ||
    (repository.split("/")[1] ?? "").startsWith(".")
  ) {
    throw new FactoryError(
      `Working Repository ${JSON.stringify(repository)} is not an org/repository name`,
    );
  }
}

/** `acme/app` → `acme__app`: one clone directory per Working Repository. Orgs cannot hold `_`. */
export function repoKey(repository: string): string {
  assertRepository(repository);
  return repository.replace("/", "__");
}

export function repositoryFromKey(key: string): string | null {
  const separator = key.indexOf("__");
  if (separator <= 0) return null;
  const repository = `${key.slice(0, separator)}/${key.slice(separator + 2)}`;
  return isRepositoryIdentity(repository) ? repository : null;
}

export const deliveryBranch = defaultDeliveryBranch;
export const containerName = (id: string) => `workset-${id}`;
/** The inner daemon's volume holding a Workset's `/home/mate`, which outlives its container. */
export const homeVolume = (id: string) => `workset-home-${id}`;
/** The Bun install cache every Workset container shares. */
export const BUN_CACHE_VOLUME = "workset-bun-cache";

export const LABEL_WORKSET = "dev.mate.workset";
export const LABEL_REPOSITORY = "dev.mate.repository";
